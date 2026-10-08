import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";

export interface ModelLookup {
	name?: string;
	contextWindow?: number;
}

function text(parent: Node, value: string): void {
	parent.appendChild(document.createTextNode(value));
}

export function renderStatus(target: HTMLElement, snapshot: SessionSnapshot, model?: ModelLookup): void {
	const parts: string[] = [snapshot.phase];
	const label = model?.name ?? `${snapshot.model.provider}/${snapshot.model.id}`;
	parts.push(label);
	parts.push(`thinking ${snapshot.thinkingLevel}`);
	if (snapshot.queuedSteerCount > 0) parts.push(`${snapshot.queuedSteerCount} queued`);
	// Water line: last assistant usage.input over the model's contextWindow (05 C-水位 as amended).
	for (let i = snapshot.transcript.length - 1; i >= 0; i--) {
		const item: TranscriptItem = snapshot.transcript[i]!;
		if (item.role === "assistant" && item.usage) {
			const tokens = item.usage.input;
			if (model?.contextWindow && model.contextWindow > 0) {
				const percent = Math.round((tokens / model.contextWindow) * 100);
				parts.push(`ctx ${(tokens / 1000).toFixed(1)}k (${percent}%)`);
			} else {
				parts.push(`ctx ${(tokens / 1000).toFixed(1)}k`);
			}
			break;
		}
	}
	target.textContent = "";
	text(target, parts.join(" · "));
}

export function renderQueue(target: HTMLElement, snapshot: SessionSnapshot): void {
	target.textContent = "";
	if (snapshot.queuedSteer.length === 0) return;
	const heading = document.createElement("div");
	heading.className = "queue-heading";
	text(heading, "Queued");
	for (const entry of snapshot.queuedSteer) {
		const row = document.createElement("div");
		row.className = "queue-entry";
		const label = entry.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		text(row, label);
		target.appendChild(row);
	}
}
