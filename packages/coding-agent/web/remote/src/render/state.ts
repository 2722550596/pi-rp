import type { AssistantTranscriptItem, SessionSnapshot, TranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";

/**
 * Snapshot/progress reducer. Entries hold snapshot-authoritative items keyed by
 * item id; live holds in-flight items keyed by local keys until the next
 * snapshot reconciles them (06 §6). applyProgress returns the touched key so
 * the DOM layer can reconcile a single entry instead of the whole list.
 */
export class TranscriptState {
	readonly entries = new Map<string, TranscriptItem>();
	readonly live = new Map<string, TranscriptItem>();
	readonly liveIdByMessageId = new Map<string, string>();
	readonly fragments = new Map<string, string>();
	snapshot: SessionSnapshot | undefined;
	#sequence = 0;

	applySnapshot(snapshot: SessionSnapshot): boolean {
		if (this.snapshot?.id === snapshot.id && snapshot.revision < this.snapshot.revision) return false;
		this.snapshot = snapshot;
		this.entries.clear();
		for (const item of snapshot.transcript) this.entries.set(item.id, item);
		this.live.clear();
		this.liveIdByMessageId.clear();
		this.fragments.clear();
		return true;
	}

	clear(): void {
		this.snapshot = undefined;
		this.entries.clear();
		this.live.clear();
		this.liveIdByMessageId.clear();
		this.fragments.clear();
	}

	/** Applies a progress event; returns the live key it touched, if any. */
	applyProgress(progress: TranscriptProgress): string | undefined {
		if (progress.type === "item_started") {
			const key = this.newKey();
			this.live.set(key, progress.item);
			if (progress.item.role === "assistant") this.liveIdByMessageId.set(progress.item.id, key);
			return key;
		}
		if (progress.type === "assistant_delta") {
			let key = this.liveIdByMessageId.get(progress.messageId);
			if (!key) {
				key = this.newKey();
				const placeholder: AssistantTranscriptItem = {
					id: progress.messageId,
					role: "assistant",
					content: [],
					model: this.snapshot?.model ?? { provider: "unknown", id: "unknown" },
					timestamp: Date.now(),
					status: "streaming",
				};
				this.live.set(key, placeholder);
				this.liveIdByMessageId.set(progress.messageId, key);
			}
			const current = this.live.get(key);
			if (!current || current.role !== "assistant") return undefined;
			const fragmentKey = `${progress.messageId}:${progress.contentIndex}`;
			const fragment = (this.fragments.get(fragmentKey) ?? "") + progress.delta;
			this.fragments.set(fragmentKey, fragment);
			const content = current.content.slice();
			const part =
				progress.kind === "text"
					? { type: "text" as const, text: fragment }
					: progress.kind === "thinking"
						? { type: "thinking" as const, thinking: fragment }
						: { type: "toolCall" as const, toolCallId: `streaming-${progress.messageId}-${progress.contentIndex}`, toolName: "Tool call", input: fragment };
			content[progress.contentIndex] = part;
			this.live.set(key, { ...current, content });
			return key;
		}
		const item = progress.item;
		let key: string | undefined;
		for (const pair of this.live) if (pair[1].id === item.id) { key = pair[0]; break; }
		if (!key && item.role === "assistant") key = this.liveIdByMessageId.get(item.id);
		if (!key) key = this.newKey();
		this.live.set(key, item);
		if (item.role === "assistant") this.liveIdByMessageId.set(item.id, key);
		return key;
	}

	newKey(): string {
		this.#sequence += 1;
		return `live-${Date.now()}-${this.#sequence}`;
	}
}
