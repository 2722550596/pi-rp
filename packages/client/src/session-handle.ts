import type {
	Command,
	ModelRef,
	ResultForCommand,
	ServerEvent,
	SessionSnapshot,
	SessionTreeEntryProjection,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import type { Unsubscribe } from "./types.ts";

type SessionCommand = Extract<Command, { sessionId: string }>;

export type SessionLeaseMode = "shared" | "exclusive";

export interface AcquireSessionOptions {
	mode: SessionLeaseMode;
}

export interface SessionLease extends AsyncDisposable {
	readonly id: string;
	readonly active: boolean;
	readonly attached: boolean;
	readonly snapshot: SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	dispose(): Promise<void>;
	prompt(text: string): Promise<SessionSnapshot>;
	steer(text: string): Promise<SessionSnapshot>;
	abort(): Promise<SessionSnapshot>;
	setModel(model: ModelRef): Promise<SessionSnapshot>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot>;
	reroll(): Promise<{ ok: boolean; session: SessionSnapshot }>;
	editMessage(entryId: string, text: string): Promise<SessionSnapshot>;
	getTree(): Promise<{ entries: SessionTreeEntryProjection[]; leafId: string }>;
	navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string; session: SessionSnapshot }>;
}

export type PiSessionHandle = SessionLease;

export interface SessionHandleCallbacks {
	isAttached(): boolean;
	getSnapshot(): SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	dispose(): Promise<void>;
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
}

export class SessionHandle implements SessionLease {
	readonly id: string;
	readonly #callbacks: SessionHandleCallbacks;

	constructor(id: string, callbacks: SessionHandleCallbacks) {
		this.id = id;
		this.#callbacks = callbacks;
	}

	get attached(): boolean {
		return this.#callbacks.isAttached();
	}

	get active(): boolean {
		return this.attached;
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.#callbacks.getSnapshot();
	}

	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.#callbacks.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#callbacks.onEvent(listener);
	}

	async detach(): Promise<void> {
		await this.#callbacks.detach();
	}

	dispose(): Promise<void> {
		return this.#callbacks.dispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async prompt(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "prompt", sessionId: this.id, text })).session;
	}

	async steer(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "steer", sessionId: this.id, text })).session;
	}

	async abort(): Promise<SessionSnapshot> {
		return (await this.#request({ command: "abort", sessionId: this.id })).session;
	}

	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_model", sessionId: this.id, model })).session;
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_thinking", sessionId: this.id, thinkingLevel })).session;
	}

	async reroll(): Promise<{ ok: boolean; session: SessionSnapshot }> {
		const result = await this.#request({ command: "reroll", sessionId: this.id });
		return { ok: result.ok, session: result.session };
	}

	async editMessage(entryId: string, text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "edit_message", sessionId: this.id, entryId, text })).session;
	}

	async getTree(): Promise<{ entries: SessionTreeEntryProjection[]; leafId: string }> {
		const result = await this.#request({ command: "get_tree", sessionId: this.id });
		return { entries: result.entries, leafId: result.leafId };
	}

	async navigateTree(targetId: string): Promise<{
		cancelled: boolean;
		editorText?: string;
		session: SessionSnapshot;
	}> {
		const result = await this.#request({ command: "navigate_tree", sessionId: this.id, targetId });
		return {
			cancelled: result.cancelled,
			...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
			session: result.session,
		};
	}

	#request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		return this.#callbacks.request(command);
	}
}
