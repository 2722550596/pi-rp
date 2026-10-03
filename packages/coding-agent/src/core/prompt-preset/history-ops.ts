import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, isTurnStartMessage } from "../compaction/compaction.ts";
import type {
	CompileMessageSource,
	HistoryOp,
	HistoryOpContext,
	HistoryOpOrigin,
	HistoryRegisteredOp,
	PromptPresetDiagnostic,
	PromptPresetHistoryItem,
	PromptRuntime,
} from "./types.ts";

export interface HistoryOpExecutionResult {
	messages: AgentMessage[];
	sources: CompileMessageSource[];
	diagnostics: PromptPresetDiagnostic[];
}

interface ResolvedInsert {
	op: Extract<HistoryOp, { op: "insert" }>;
	origin: HistoryOpOrigin;
	order: number;
	itemId?: string;
}

/** Session-owned dynamic operation registry; each snapshot is isolated from later disposals. */
export class HistoryOpRegistry {
	private readonly registrations = new Map<symbol, { registered: HistoryRegisteredOp; owner: string }>();
	private nextOrder = 0;

	register(extensionId: string, op: HistoryOp): () => void {
		if (!extensionId || !op || typeof op !== "object") throw new Error("Invalid history operation registration");
		if (op.op === "insert") {
			if (!op.id || typeof op.id !== "string" || !Number.isInteger(op.depth) || op.depth < 0) {
				throw new Error(`Invalid history insert registered by extension "${extensionId}"`);
			}
			if (typeof op.render !== "function") throw new Error(`History insert "${op.id}" requires a render function`);
		} else if (op.op === "keep") {
			const hasTokens = op.tokens !== undefined;
			const hasTraces = op.traces !== undefined;
			const amount = hasTokens ? op.tokens : op.traces;
			if (hasTokens === hasTraces || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
				throw new Error("History keep must specify exactly one non-negative finite tokens or traces value");
			}
		} else if (op.op !== "reduce" || (op.as !== "summary" && op.as !== "hide")) {
			throw new Error("Invalid history operation registration");
		}
		if (
			op.op === "insert"
				? [...this.registrations.values()].some(
						({ registered, owner }) =>
							owner === extensionId && registered.op.op === "insert" && registered.op.id === op.id,
					)
				: [...this.registrations.values()].some(({ registered }) => registered.op.op === op.op)
		) {
			throw new Error(
				op.op === "insert"
					? `History operation "${op.id}" is already registered by extension "${extensionId}"`
					: `A dynamic "${op.op}" operation is already registered for this session`,
			);
		}
		const key = Symbol(op.op === "insert" ? op.id : op.op);
		const registered: HistoryRegisteredOp = {
			op,
			origin:
				op.op === "insert"
					? { kind: "extension", extensionId, opId: op.id }
					: { kind: "extension", extensionId, opId: op.op },
			order: this.nextOrder++,
		};
		this.registrations.set(key, { registered, owner: extensionId });
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.registrations.delete(key);
		};
	}

	snapshot(): HistoryRegisteredOp[] {
		return [...this.registrations.values()].map(({ registered }) => registered);
	}

	clear(): void {
		this.registrations.clear();
	}
}

/** Execute the already-filtered history stream's keep/reduce/insert operations. */
export async function executeHistoryOps(
	baseMessages: readonly AgentMessage[],
	item: PromptPresetHistoryItem | undefined,
	presetId: string,
	runtime: PromptRuntime,
): Promise<HistoryOpExecutionResult> {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const { snapshot } = windowMessages(baseMessages, item, runtime);
	const hostDataSnapshot = await loadHostData(runtime, item?.ops ?? []);
	const context: HistoryOpContext = {
		messages: snapshot,
		runtime,
		hostData: hostDataSnapshot.data,
		signal: runtime.signal ?? new AbortController().signal,
	};
	const rendered: Array<{ insert: ResolvedInsert; output: readonly AgentMessage[] }> = [];
	for (const insert of collectInserts(item, presetId, runtime)) {
		const duplicateNamespace = (insert.op.hostData ?? [])
			.map(({ namespace }) => namespace)
			.find((namespace) => hostDataSnapshot.duplicateNamespaces.has(namespace));
		if (duplicateNamespace) {
			diagnostics.push({
				level: "error",
				code: "history-host-data-namespace-duplicate",
				itemId: insert.itemId,
				origin: insert.origin,
				message: `Multiple history host-data providers use namespace "${duplicateNamespace}"; only the first provider is used.`,
			});
		}
		const failedDependency = (insert.op.hostData ?? []).find(({ namespace, key }) =>
			hostDataSnapshot.failures.has(`${namespace}\u0000${key}`),
		);
		if (failedDependency) {
			const failure = hostDataSnapshot.failures.get(`${failedDependency.namespace}\u0000${failedDependency.key}`);
			diagnostics.push({
				level: "error",
				code: "history-op-render-failed",
				itemId: insert.itemId,
				origin: insert.origin,
				message: `History operation "${insert.op.id}" host data ${failedDependency.namespace}.${failedDependency.key} failed: ${failure}`,
			});
			continue;
		}
		if (context.signal.aborted) throw abortError(context.signal);
		try {
			const pending = insert.op.render
				? insert.op.render(context)
				: typeof insert.op.content === "string"
					? [textMessage(insert.op.content)]
					: [];
			if (isPromiseLike(pending) && insert.op.async !== true) {
				throw new Error("returned a Promise without declaring async: true");
			}
			const output = await pending;
			if (context.signal.aborted) throw abortError(context.signal);
			if (!Array.isArray(output) || output.some((message) => !isAgentMessage(message))) {
				diagnostics.push({
					level: "error",
					code: "history-op-render-failed",
					itemId: insert.itemId,
					origin: insert.origin,
					message: `History operation "${insert.op.id}" returned invalid messages; its output was discarded.`,
				});
				continue;
			}
			rendered.push({ insert, output });
		} catch (error) {
			if (context.signal.aborted) throw error;
			diagnostics.push({
				level: "error",
				code: "history-op-render-failed",
				itemId: insert.itemId,
				origin: insert.origin,
				message: `History operation "${insert.op.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return finishInserts(snapshot, rendered, diagnostics, item?.id);
}

/** Synchronous preview path: never invokes declared async renderers or providers. */
export function executeHistoryOpsSync(
	baseMessages: readonly AgentMessage[],
	item: PromptPresetHistoryItem | undefined,
	presetId: string,
	runtime: PromptRuntime,
): HistoryOpExecutionResult {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const { snapshot } = windowMessages(baseMessages, item, runtime);
	const context: HistoryOpContext = {
		messages: snapshot,
		runtime,
		hostData: {},
		signal: runtime.signal ?? new AbortController().signal,
	};
	const rendered: Array<{ insert: ResolvedInsert; output: readonly AgentMessage[] }> = [];
	for (const insert of collectInserts(item, presetId, runtime)) {
		if (context.signal.aborted) throw abortError(context.signal);
		if (insert.op.async === true || (insert.op.hostData?.length ?? 0) > 0) {
			diagnostics.push({
				level: "info",
				itemId: insert.itemId,
				message: `Async history operation "${insert.op.id}" requires async compilation; skipping it.`,
			});
			continue;
		}
		try {
			const output = insert.op.render
				? insert.op.render(context)
				: typeof insert.op.content === "string"
					? [textMessage(insert.op.content)]
					: [];
			if (isPromiseLike(output)) {
				void Promise.resolve(output).catch(() => {});
				diagnostics.push({
					level: "error",
					code: "history-op-render-failed",
					itemId: insert.itemId,
					origin: insert.origin,
					message: `History operation "${insert.op.id}" returned a Promise without declaring async: true; its output was discarded.`,
				});
				continue;
			}
			if (!Array.isArray(output) || output.some((message) => !isAgentMessage(message))) {
				diagnostics.push({
					level: "error",
					code: "history-op-render-failed",
					itemId: insert.itemId,
					origin: insert.origin,
					message: `History operation "${insert.op.id}" returned invalid messages; its output was discarded.`,
				});
				continue;
			}
			rendered.push({ insert, output });
		} catch (error) {
			if (context.signal.aborted) throw error;
			diagnostics.push({
				level: "error",
				code: "history-op-render-failed",
				itemId: insert.itemId,
				origin: insert.origin,
				message: `History operation "${insert.op.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return finishInserts(snapshot, rendered, diagnostics, item?.id);
}

function windowMessages(
	baseMessages: readonly AgentMessage[],
	item: PromptPresetHistoryItem | undefined,
	runtime: PromptRuntime,
): { messages: AgentMessage[]; snapshot: AgentMessage[] } {
	const operations = [...(runtime.historyOps ?? []).map((entry) => entry.op), ...(item?.ops ?? [])];
	const keep = operations.find((op): op is Extract<HistoryOp, { op: "keep" }> => op.op === "keep");
	const reduce = operations.find((op): op is Extract<HistoryOp, { op: "reduce" }> => op.op === "reduce");
	const window = applyWindow(baseMessages, keep);
	const messages =
		reduce?.as === "hide"
			? window.kept
			: reduce?.as === "summary"
				? [...window.summaries, ...window.kept]
				: [...baseMessages];
	return { messages, snapshot: messages.slice() };
}

function collectInserts(
	item: PromptPresetHistoryItem | undefined,
	presetId: string,
	runtime: PromptRuntime,
): ResolvedInsert[] {
	const inserts: ResolvedInsert[] = [];
	for (const registered of runtime.historyOps ?? []) {
		if (registered.op.op === "insert") inserts.push({ ...registered, op: registered.op });
	}
	for (let index = 0; index < (item?.ops.length ?? 0); index++) {
		const op = item!.ops[index];
		if (op.op === "insert")
			inserts.push({
				op,
				origin: { kind: "preset", presetId, itemId: item!.id, opIndex: index },
				order: index,
				itemId: item!.id,
			});
	}
	return inserts;
}

function finishInserts(
	snapshot: readonly AgentMessage[],
	rendered: Array<{ insert: ResolvedInsert; output: readonly AgentMessage[] }>,
	diagnostics: PromptPresetDiagnostic[],
	itemId?: string,
): HistoryOpExecutionResult {
	const placed = rendered.flatMap(({ insert, output }) => {
		const depth = Math.max(0, Math.min(snapshot.length, snapshot.length - insert.op.depth));
		if (insert.op.depth > snapshot.length)
			diagnostics.push({
				level: "warning",
				code: "history-op-depth-clamped",
				itemId: insert.itemId ?? itemId,
				origin: insert.origin,
				message: `History operation "${insert.op.id}" depth was clamped to the start of the retained history.`,
			});
		return output.map((message) => ({
			message,
			source: { kind: "history-op" as const, opId: insert.op.id, origin: insert.origin, itemId: insert.itemId },
			position: depth,
			order: insert.order,
			originKind: insert.origin.kind,
		}));
	});
	const buckets = new Map<number, typeof placed>();
	for (const insertion of placed) {
		const bucket = buckets.get(insertion.position);
		if (bucket) bucket.push(insertion);
		else buckets.set(insertion.position, [insertion]);
	}
	const messages: AgentMessage[] = [];
	const sources: CompileMessageSource[] = [];
	for (let gap = 0; gap <= snapshot.length; gap++) {
		const bucket = buckets.get(gap) ?? [];
		bucket.sort((a, b) =>
			a.originKind === b.originKind ? a.order - b.order : a.originKind === "extension" ? -1 : 1,
		);
		for (const insertion of bucket) {
			messages.push(insertion.message);
			sources.push(insertion.source);
		}
		if (gap < snapshot.length) {
			messages.push(snapshot[gap]);
			sources.push({ kind: "chat-history" });
		}
	}
	return { messages, sources, diagnostics };
}

function applyWindow(
	messages: readonly AgentMessage[],
	keep: Extract<HistoryOp, { op: "keep" }> | undefined,
): { kept: AgentMessage[]; summaries: AgentMessage[] } {
	if (!keep) return { kept: [...messages], summaries: [] };
	let start = 0;
	if (keep.tokens !== undefined) {
		let total = 0;
		start = messages.length;
		for (let index = messages.length - 1; index >= 0; index--) {
			total += estimateTokens(messages[index]);
			start = index;
			if (total >= keep.tokens) break;
		}
		if (keep.tokens === 0) start = messages.length;
	} else {
		const starts = messages
			.map((message, index) => (isTurnStartMessage(message) ? index : -1))
			.filter((index) => index >= 0);
		start = keep.traces === 0 ? messages.length : (starts[Math.max(0, starts.length - (keep.traces ?? 0))] ?? 0);
	}
	return {
		kept: messages.slice(start),
		summaries: messages
			.slice(0, start)
			.filter((message) => message.role === "branchSummary" || message.role === "compactionSummary"),
	};
}

async function loadHostData(
	runtime: PromptRuntime,
	ops: readonly HistoryOp[],
): Promise<{
	data: HistoryOpContext["hostData"];
	failures: Map<string, string>;
	duplicateNamespaces: Set<string>;
}> {
	const declared = [
		...ops.filter((op): op is Extract<HistoryOp, { op: "insert" }> => op.op === "insert"),
		...(runtime.historyOps ?? []).flatMap((registered) => (registered.op.op === "insert" ? [registered.op] : [])),
	].flatMap((op) => op.hostData ?? []);
	const data: Record<string, Record<string, { value: unknown; version?: string | number }>> = {};
	const failures = new Map<string, string>();
	const providers = new Map<string, NonNullable<PromptRuntime["historyHostData"]>[number]>();
	const duplicateNamespaces = new Set<string>();
	for (const provider of runtime.historyHostData ?? []) {
		if (providers.has(provider.namespace)) duplicateNamespaces.add(provider.namespace);
		else providers.set(provider.namespace, provider);
	}
	for (const { namespace, key } of declared) {
		const dataKey = `${namespace}\u0000${key}`;
		if (Object.hasOwn(data[namespace] ?? {}, key) || failures.has(dataKey)) continue;
		const provider = providers.get(namespace);
		if (!provider) {
			failures.set(dataKey, `no provider registered for namespace "${namespace}"`);
			continue;
		}
		try {
			const value = await provider.get(key, runtime);
			if (runtime.signal?.aborted) throw abortError(runtime.signal);
			// Versions are exposed for deterministic callers; keyed render caching is
			// deferred until measured performance demand. See history-ops-detail-design §10.
			const version = provider.version?.(key);
			let bucket = data[namespace];
			if (bucket === undefined) {
				bucket = {};
				data[namespace] = bucket;
			}
			bucket[key] = version === undefined ? { value } : { value, version };
		} catch (error) {
			if (runtime.signal?.aborted) throw error;
			failures.set(dataKey, error instanceof Error ? error.message : String(error));
		}
	}
	return { data, failures, duplicateNamespaces };
}

function isAgentMessage(value: unknown): value is AgentMessage {
	if (!value || typeof value !== "object") return false;
	if (!("role" in value) || typeof value.role !== "string") return false;
	return "content" in value && Array.isArray(value.content);
}

function textMessage(text: string): AgentMessage {
	return { role: "custom", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		!!value &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("History compilation aborted", "AbortError");
}
